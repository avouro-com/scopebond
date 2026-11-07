---
"@scopebond/hook": patch
---

Claude Code's sub-agent and task-list tools (`SendMessage`, `ListAgents`, `ReadNotifications`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`) are known as harmless and recorded, as `Agent` and `TodoWrite` already were, instead of refused as unknown. Tools that start work later or elsewhere (`Monitor`, `CronCreate`, `ScheduleWakeup`, `RemoteTrigger`, `Workflow`, `PushNotification`, `SendUserFile`) stay refused until a rule names them.
