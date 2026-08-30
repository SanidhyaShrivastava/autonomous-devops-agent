import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  setupChecks: defineTable({
    label: v.string(),
    createdAt: v.number(),
  }),
});
