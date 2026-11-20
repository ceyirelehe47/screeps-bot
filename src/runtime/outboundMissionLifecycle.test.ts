import { createOutboundLifecycle, deferOutboundTask, orderOutboundWork, outboundPhase, outboundRetryDue } from "@/runtime/outboundMissionLifecycle";
import { outboundStatusRaw } from "@/runtime/console/outboundStatus";
import type { DepositHarvestTask } from "@/runtime/depositHarvest";

it("旧生产记录映射为共同阶段，临时等待有明确边界，到期后恢复原阶段", () => {
  Game.time = 101;
  const task = { status:"spawning", id:"d", sourceRoom:"W1N1", targetRoom:"W2N1" } as DepositHarvestTask;
  deferOutboundTask(task, "source_busy", 5);
  expect(outboundPhase("deposit",task)).toBe("waiting");
  expect(outboundRetryDue(task)).toBe(false);
  Game.time += 5;
  expect(outboundRetryDue(task)).toBe(true);
  expect(outboundPhase("deposit",task)).toBe("preparing");
  task.status = "returning";
  deferOutboundTask(task, "delivery_pending", 2);
  expect(outboundPhase("deposit",task)).toBe("returning");
  Memory.data = {depositHarvest:{d:task}};
  const before = JSON.stringify(Memory.data);
  expect(outboundStatusRaw({room:"W2N1",family:"deposit"}).tasks).toMatchObject([{id:"d",phase:"returning"}]);
  expect(outboundStatusRaw({room:"W9N9"}).tasks).toEqual([]);
  expect(JSON.stringify(Memory.data)).toBe(before);
});

it("即使 owner 的旧转移表过宽，已关闭的身份也不能被复活", () => {
  const life = createOutboundLifecycle("colonizationSupport", {
    waiting_claim:["supporting"], supporting:["complete"], paused:["supporting"], complete:["supporting"],
  }, () => "support-run");
  expect(() => life.transition({status:"complete"},"supporting")).toThrow("外出任务已结束");
  expect(life.transition({status:"complete"},"complete")).toBe(false);
});

it("运输先于新出征，同类新候选沿用该任务的公平顺序", () => {
  const tasks = [{status:"discovered",id:2}, {status:"attacking",id:1}, {status:"hauling",id:3}, {status:"discovered",id:0}] as const;
  expect(orderOutboundWork("powerBank",tasks,(a,b)=>a.id-b.id).map(t=>t.id)).toEqual([3,1,0,2]);
});
