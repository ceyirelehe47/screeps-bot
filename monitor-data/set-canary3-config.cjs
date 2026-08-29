// Canary3 配置：开启市场诊断 100-tick 窗口 + movement rooms（与 baseline 对称）。
const fs = require("fs");
const token = fs.readFileSync("D:/code/screeps/screeps-bot/.env", "utf8").match(/SCREEPS_TOKEN=(.+)/)[1].trim();

async function setMemory(path, value) {
  const r = await fetch("https://screeps.com/api/user/memory?shard=shard1", {
    method: "POST",
    headers: { "X-Token": token, "X-Username": token, "Content-Type": "application/json" },
    body: JSON.stringify({ path, value }),
  });
  console.log(path, "->", await r.text());
}

(async () => {
  await setMemory("cfg.marketSaleDiagnostics", { enabled: true, windowTicks: 100 });
  await setMemory("cfg.movementMetrics", { mode: "rooms" });
})();
