export default function startMumbaiDesk() {
  void import("../../src/lib/dhan/watcher.server.ts").then((mod) => mod.startDesk());
}
