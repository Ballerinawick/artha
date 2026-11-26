export default function startMumbaiDesk() {
  setTimeout(() => {
    void import("../../src/lib/dhan/watcher.server.ts").then((mod) => mod.startDesk());
  }, 1000);
}
