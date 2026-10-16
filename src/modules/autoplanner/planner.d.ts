declare const planner: {
  runPlan(roomName: string): boolean;
  visualizePlan(roomName: string): boolean;
  savePlanToMemory(roomName: string): boolean;
};
export default planner;
