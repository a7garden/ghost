import Foundation
import Speech
import AVFoundation

// Persistent speech-to-text helper over Apple's on-device SpeechAnalyzer (macOS 26+).
// Protocol: one JSON object per stdin line: {"path": "<wav>", "locale": "ko_KR"} or {"ping": true}.
// One JSON line per reply: {"text": "..."} | {"ok": true} | {"error": "<code>"}. Nothing else goes to stdout.

setvbuf(stdout, nil, _IOLBF, 0)

func reply(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

func makeTranscriber(_ locale: Locale) -> SpeechTranscriber {
    SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
}

var installed = Set<String>()

func ensureAsset(_ locale: Locale) async throws {
    guard !installed.contains(locale.identifier) else { return }
    let probe = makeTranscriber(locale)
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
        try await request.downloadAndInstall()
    }
    installed.insert(locale.identifier)
}

// A SpeechTranscriber cannot be reused across analyzers, so each file gets a new one.
func transcribe(path: String, locale: Locale) async throws -> String {
    try await ensureAsset(locale)
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    let transcriber = makeTranscriber(locale)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let collector = Task { () -> String in
        var text = ""
        for try await result in transcriber.results where result.isFinal { text += String(result.text.characters) }
        return text
    }
    if let last = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: last)
    } else {
        await analyzer.cancelAndFinishNow()
    }
    return try await collector.value
}

guard SpeechTranscriber.isAvailable else {
    reply(["error": "speech_unavailable"])
    exit(2)
}

while let line = readLine() {
    guard let data = line.data(using: .utf8), let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        reply(["error": "bad_request"])
        continue
    }
    if request["ping"] != nil {
        reply(["ok": true])
        continue
    }
    guard let path = request["path"] as? String, let identifier = request["locale"] as? String else {
        reply(["error": "bad_request"])
        continue
    }
    do {
        reply(["text": try await transcribe(path: path, locale: Locale(identifier: identifier)).replacingOccurrences(of: "\n", with: " ")])
    } catch {
        reply(["error": "transcription_failed"])
    }
}
