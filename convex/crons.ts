import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "watch active recovery run",
  { seconds: 2 },
  internal.runner.watchActiveRun,
  {},
);

export default crons;
