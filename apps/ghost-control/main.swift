// Ghost Control: the macOS privacy identity for Ghost's PC control.
//
// macOS grants Accessibility and Screen Recording to the *responsible* process. Granted to the Host, they
// would cover every command it runs. This signed bundle (dev.projectoxi.ghost.control) disclaims
// responsibility on start, so macOS attributes everything it and its children do to this bundle alone; the
// owner grants it once. It runs only the
// two executables it was started with (agent-desktop and Geist) on behalf of the Host, one request at a time,
// over newline-delimited JSON on stdin/stdout.
import ApplicationServices
import CoreGraphics
import CoreServices
import Darwin
import Foundation

@_silgen_name("responsibility_spawnattrs_setdisclaim")
private func responsibility_spawnattrs_setdisclaim(_ attr: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

private let responsibleMarker = "GHOST_CONTROL_RESPONSIBLE"
private let maxStdout = 40 * 1024 * 1024
private let maxStderr = 64 * 1024
private let maxTimeoutMs = 180_000

private func fail(_ message: String, code: Int32 = 1) -> Never {
  FileHandle.standardError.write(Data("ghost-control: \(message)\n".utf8))
  exit(code)
}

private func emit(_ object: [String: Any]) {
  guard var data = try? JSONSerialization.data(withJSONObject: object, options: []) else { fail("could not encode a reply") }
  data.append(0x0A)
  FileHandle.standardOutput.write(data)
}

/// Re-execute this binary in place (same pid and stdio) as its own responsible process.
private func becomeResponsible() {
  if getenv(responsibleMarker) != nil {
    unsetenv(responsibleMarker)
    return
  }
  setenv(responsibleMarker, "1", 1)
  var attr: posix_spawnattr_t?
  guard posix_spawnattr_init(&attr) == 0 else { fail("posix_spawnattr_init failed") }
  guard posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC)) == 0 else { fail("posix_spawnattr_setflags failed") }
  guard responsibility_spawnattrs_setdisclaim(&attr, 1) == 0 else { fail("could not disclaim responsibility") }
  guard let executable = Bundle.main.executablePath else { fail("no executable path") }
  let argv = CommandLine.arguments.map { strdup($0) } + [nil]
  let status = posix_spawn(nil, executable, nil, &attr, argv, environ)
  fail("could not re-execute as the responsible process (\(status))")
}

private func permissions() -> [String: Any] {
  ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
}

private func requestPermissions() -> [String: Any] {
  let prompt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  _ = AXIsProcessTrustedWithOptions(prompt)
  if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
  return permissions()
}

/// Diagnostic HID idle time; synthesized pointer input resets this too, so it cannot prove owner inactivity.
private func hidIdleSeconds() -> Double {
  CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
}

private func homeDirectory() -> String {
  guard let entry = getpwuid(getuid()), let dir = entry.pointee.pw_dir else { fail("no home directory") }
  return String(cString: dir)
}

/// An executable the Host named: absolute, a regular file owned by this user, not writable by others.
private func trustedExecutable(_ path: String) -> String {
  guard path.hasPrefix("/") else { fail("executable paths must be absolute") }
  var info = stat()
  guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
        (info.st_mode & 0o022) == 0, (info.st_mode & 0o100) != 0 else { fail("refusing executable \(path)") }
  return path
}

private func privateDirectory(_ path: String) -> String {
  guard path.hasPrefix("/") else { fail("the state directory must be absolute") }
  mkdir(path, 0o700)
  var info = stat()
  guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid(),
        (info.st_mode & 0o077) == 0 else { fail("refusing state directory \(path)") }
  return path
}

private final class Bounded {
  private let lock = NSLock()
  private var data = Data()
  private let limit: Int
  private(set) var exceeded = false
  init(limit: Int) { self.limit = limit }
  func append(_ chunk: Data) {
    lock.lock(); defer { lock.unlock() }
    if data.count + chunk.count > limit { exceeded = true; return }
    data.append(chunk)
  }
  var text: String { lock.lock(); defer { lock.unlock() }; return String(decoding: data, as: UTF8.self) }
}

private final class ReadCancellation {
  private let lock = NSLock()
  private var stopped = false
  func cancel() { lock.lock(); stopped = true; lock.unlock() }
  var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
}

private final class Runner {
  let tools: [String: String]
  let environment: [String: String]
  let workingDirectory: URL
  private let lock = NSLock()
  private let execution = NSLock()
  private var current: Process?

  init(tools: [String: String], environment: [String: String], workingDirectory: URL) {
    self.tools = tools
    self.environment = environment
    self.workingDirectory = workingDirectory
  }

  func run(tool: String, args: [String], stdin: String?, timeoutMs: Int) -> [String: Any] {
    guard let executable = tools[tool] else { return ["error": "unknown tool"] }
    execution.lock(); defer { execution.unlock() }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = args
    process.environment = environment
    process.currentDirectoryURL = workingDirectory
    let input = Pipe(), output = Pipe(), errors = Pipe()
    process.standardInput = input
    process.standardOutput = output
    process.standardError = errors
    let stdout = Bounded(limit: maxStdout), stderr = Bounded(limit: maxStderr)
    do { try process.run() } catch { return ["error": "could not start \(tool)"] }
    let drained = DispatchGroup()
    let reads = ReadCancellation()
    for (pipe, sink) in [(output, stdout), (errors, stderr)] {
      drained.enter()
      DispatchQueue.global().async {
        let handle = pipe.fileHandleForReading
        while !reads.cancelled {
          var descriptor = pollfd(fd: handle.fileDescriptor, events: Int16(POLLIN | POLLHUP), revents: 0)
          let ready = poll(&descriptor, 1, 100)
          if ready < 0 { if errno == EINTR { continue }; break }
          if ready == 0 { continue }
          let chunk = handle.availableData
          if chunk.isEmpty { break }
          sink.append(chunk)
          if sink.exceeded { process.terminate() }
        }
        try? handle.close()
        drained.leave()
      }
    }
    lock.lock(); current = process; lock.unlock()
    let timeoutLock = NSLock()
    var timedOut = false
    var finished = false
    let deadline = DispatchWorkItem {
      timeoutLock.lock()
      if finished { timeoutLock.unlock(); return }
      timedOut = true
      timeoutLock.unlock()
      process.terminate()
      DispatchQueue.global().asyncAfter(deadline: .now() + 1) { if process.isRunning { kill(process.processIdentifier, SIGKILL) } }
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(min(max(timeoutMs, 1), maxTimeoutMs)), execute: deadline)
    DispatchQueue.global().async {
      if let stdin { try? input.fileHandleForWriting.write(contentsOf: Data(stdin.utf8)) }
      try? input.fileHandleForWriting.close()
    }
    process.waitUntilExit()
    timeoutLock.lock()
    finished = true
    let expired = timedOut
    timeoutLock.unlock()
    deadline.cancel()
    // A runtime may exit while a descendant still owns its pipes. Do not let that hold the PC queue indefinitely.
    let drainedNormally = drained.wait(timeout: .now() + 1) == .success
    if !drainedNormally {
      reads.cancel()
      _ = drained.wait(timeout: .now() + .milliseconds(250))
    }
    lock.lock(); current = nil; lock.unlock()
    return [
      "code": Int(process.terminationStatus),
      "stdout": stdout.text,
      "stderr": stderr.text,
      "timedOut": expired || !drainedNormally,
      "truncated": stdout.exceeded,
    ]
  }

  func terminateCurrent() {
    lock.lock(); let process = current; lock.unlock()
    process?.terminate()
  }
}

private func serve(_ options: [String: String]) -> Never {
  guard let agentDesktop = options["--agent-desktop"], let geist = options["--geist"], let state = options["--state"] else {
    fail("usage: ghost-control serve --agent-desktop PATH --geist PATH --state DIR", code: 2)
  }
  let stateDir = privateDirectory(state)
  let desktopHome = privateDirectory(stateDir + "/agent-desktop")
  let tmp = privateDirectory(stateDir + "/tmp")
  let runner = Runner(
    tools: ["agent-desktop": trustedExecutable(agentDesktop), "geist": trustedExecutable(geist)],
    environment: [
      "HOME": homeDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": tmp + "/",
      "AGENT_DESKTOP_HOME": desktopHome, "AGENT_UI_NO_UPDATE_CHECK": "1",
    ],
    workingDirectory: URL(fileURLWithPath: stateDir))
  // A Geist worker outlives its CLI call; stop it with us so none keeps running after its responsible process.
  let shutdown = {
    runner.terminateCurrent()
    let result = runner.run(tool: "geist", args: ["stop", "--json"], stdin: nil, timeoutMs: 5_000)
    let stopped = result["code"] as? Int == 0 && result["timedOut"] as? Bool == false && result["truncated"] as? Bool == false
    exit(stopped ? 0 : 1)
  }
  var sources: [DispatchSourceSignal] = []
  for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .global())
    source.setEventHandler(handler: shutdown)
    source.resume()
    sources.append(source)
  }
  signal(SIGPIPE, SIG_IGN)
  emit(["ready": true, "pid": Int(getpid())].merging(permissions()) { $1 })
  while let line = readLine(strippingNewline: true) {
    guard line.utf8.count <= 4 * 1024 * 1024,
          let request = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
          let id = request["id"] as? Int else {
      emit(["id": -1, "error": "invalid request"])
      continue
    }
    switch request["op"] as? String {
    case "status":
      emit(["id": id, "idleSeconds": hidIdleSeconds()].merging(permissions()) { $1 })
    case "run":
      guard let tool = request["tool"] as? String, let args = request["args"] as? [String] else {
        emit(["id": id, "error": "invalid run request"])
        continue
      }
      let reply = runner.run(tool: tool, args: args, stdin: request["stdin"] as? String, timeoutMs: request["timeoutMs"] as? Int ?? 30_000)
      emit(["id": id].merging(reply) { $1 })
    default:
      emit(["id": id, "error": "unknown op"])
    }
  }
  withExtendedLifetime(sources) { shutdown() }
  exit(0)
}

becomeResponsible()
// Privacy Settings resolves its rows through LaunchServices even when the binary was started directly by
// launchd. Without registration TCC can save a grant that Settings cannot display (kLSApplicationNotFoundErr).
let registration = LSRegisterURL(Bundle.main.bundleURL as CFURL, true)
guard registration == noErr else { fail("could not register the privacy identity (\(registration))") }
let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case "serve":
  var options: [String: String] = [:]
  var rest = arguments.dropFirst()
  while let key = rest.popFirst() {
    guard key.hasPrefix("--"), let value = rest.popFirst() else { fail("invalid arguments", code: 2) }
    options[key] = value
  }
  serve(options)
case "permissions":
  emit(arguments.contains("--request") ? requestPermissions() : permissions())
case nil:
  // Opened from Finder: ask macOS for the two permissions this identity needs.
  emit(requestPermissions())
default:
  fail("usage: ghost-control serve … | permissions [--request]", code: 2)
}
