// 从 stdin 的 jest --json 结果提取 per-file 用例计数（锚点更新辅助）。
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  const r = JSON.parse(s);
  const counts = {};
  for (const tr of r.testResults) {
    const normalized = tr.name.split("\\").join("/");
    const f = normalized.split("screeps-bot/").pop();
    counts[f] = tr.assertionResults.filter((a) => a.status !== "skipped").length;
  }
  require("fs").writeFileSync(
    "monitor-data/jest-file-counts.json",
    JSON.stringify(counts, null, 1),
  );
  console.log("suites", r.numTotalTestSuites, "tests", r.numTotalTests);
});
