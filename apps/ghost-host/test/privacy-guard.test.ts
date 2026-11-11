import { expect, test } from "bun:test";
import { privacyGuardedCommand } from "../src/sandbox/privacy-guard.ts";

const home = "/Users/owner";
const project = `${home}/Workspace/Projects/ghost`;
const check = (command: string, cwd = project) => privacyGuardedCommand(command, { home, cwd });

test.each([
  // Observed: these waited hours on an unanswered consent prompt.
  ["ls -d ~/Documents/Workspace/Projects/* 2>/dev/null | head -80", project],
  ['find / -name "itchio-launch-pack-v3.md" -not -path "*/proc/*" 2>/dev/null | head', project],
  ['ls -la ~; find / -maxdepth 4 -iname "*itchio*" 2>/dev/null | head -20', project],
  ['cat "$HOME/Desktop/notes.txt"', project],
  ["cp out.png ${HOME}/Downloads/", project],
  [`open ${home}/Pictures`, project],
  ["sqlite3 ~/Library/Messages/chat.db .tables", project],
  ["ls ~/Library/Mobile\\ Documents", project],
  ['ls "$HOME/Library/Group Containers"', project],
  ["OUT=~/Movies/clip.mov ffmpeg -i in.mov $OUT", project],
  ["cd ~ && find . -name '*.md'", project],
  ["cd && ls Documents", project],
  ["rg TODO", home],
  ["grep -rn password ~", project],
  ["du -sh ~/*", project],
  ["ls -R ~/Library", project],
  ["sudo find /Users -name id_rsa", project],
  ["find \"$HOME\" -type f", project],
  ["cat ~/Desktop/todo.txt", `${home}/Documents/legacy-project`],
  ["ls ../other-project", `${home}/Documents/legacy-project`],
  ["fd -H config /", project],
  ["rg --files /", project],
  ["env -i find /", project],
  ["nice -n 5 find / -name x", project],
  ["cp -r ~ /tmp/x", project],
  ["rsync -a ~/ /Volumes/backup/", project],
  ["tar czf home.tgz ~", project],
])("refuses %s", (command, cwd) => {
  expect(check(command, cwd)).toContain("macOS privacy");
});

test.each([
  ["ls -la ~/.omp/ 2>/dev/null; ls -la \"$HOME/Library/Application Support/Ghost/\"", project],
  ["find ~/Workspace/Projects -maxdepth 2 -name package.json", project],
  ['grep -n "Documents" README.md', project],
  ["rg Documents src", project],
  ["ls ~", project],
  ["ls -la /Users/owner", project],
  ["echo ~/Documentsx", project],
  ["find . -name '*.ts'", project],
  ["git -C ~/Workspace/Projects/infra status --short", project],
  ["du -sh ~/Workspace/Projects/*", project],
  ["grep -rn TODO .", project],
  ["ls -la docs", home + "/Workspace"],
  ["echo 'find / -name x'", project],
  // The owner chose this working directory; it stays usable.
  ["ls src && cat README.md", `${home}/Documents/legacy-project`],
  ["rg --files ~/Workspace/Projects", project],
  ["cp -r src /tmp/out && rsync -a ./ build/", project],
  ["tar xzf release.tar.gz", project],
])("allows %s", (command, cwd) => {
  expect(check(command, cwd)).toBeNull();
});
