# Changelog

- The project now has an isolated Next.js app and a connected Convex cloud development deployment.
- The project now has a public GitHub repository connected to its Vercel deployment.
- A visitor can now see a clear public setup-status page for the isolated Autonomous DevOps Agent project.
- The app backend can now write a non-sensitive setup record to Convex and read the same record back.
- The controlled runner can now stop one labelled disposable service, reject unsafe or duplicate recovery requests, restart it once, and verify fresh health.
- A developer can now run tested safety rules that block skipped incident phases, repeat recovery execution, unsafe action requests, and false resolution without fresh exact health evidence.
- The controlled runner can now save and safely resume one bounded recovery run in Convex, while visitors can read only a redacted trace that clearly labels the run as staged.
- A recovery run can now turn bounded failed-health, container-state, and sanitized-log evidence into one strict diagnosis while keeping ChatGPT auth, host files, and executable authority outside the model's reach.
- A visitor can now inspect live runner status, recovery evidence, and measured verification results on one responsive screen.
