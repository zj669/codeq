// Child-process writer for atomic-write.test.js. Hammers touchGraphSource on a
// bucket for <durationMs> so a concurrent reader can try to catch a torn
// root.json. Usage: node atomic-writer.js <bucket> <durationMs>
import { touchGraphSource } from "../../src/graph-share.js";

const bucket = process.argv[2];
const durationMs = Number(process.argv[3] || "1000");
const deadline = Date.now() + durationMs;
const source = { bucket };
while (Date.now() < deadline) {
  touchGraphSource(source, Date.now());
}
process.exit(0);
