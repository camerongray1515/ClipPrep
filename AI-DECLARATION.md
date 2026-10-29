---
version: "0.1.2"
level: copilot
processes:
  design: copilot
  implementation: copilot
  testing: copilot
  documentation: copilot
  deployment: copilot
---

## Notes

- ClipPrep was built with an AI coding agent (Claude Code) working at copilot level. The human set the goals and requirements: the cue-tone workflow, repeated-phrase matching, Sony sidecar status handling, macOS-only scope and default settings. The agent carried out each task end to end and checked with the human on decisions and on actions outside the project, such as launching or importing into Final Cut Pro.
- **Design:** the agent proposed the architecture and the analysis approach: per-tone transcription chunks, DTW word timings, fuzzy retake matching and FCPXML keyword ranges. The human directed the scope and changed defaults during development.
- **Implementation:** the agent wrote all of the application code (`src/`, `scripts/`).
- **Testing:** the agent wrote the unit tests (`test/`) and the UI smoke test, and tuned the detection heuristics against the human's real footage. The human tested the results in Final Cut Pro and reported problems, such as keyword ranges going missing because of a timecode mismatch. The agent then diagnosed and fixed them.
- **Documentation:** the agent wrote `README.md`, `AGENTS.md`, `docs/BUILDING.md` and the code comments.
- **Deployment:** the agent wrote the electron-builder packaging configuration and the build instructions. There is no CI/CD.
- **Review:** there has been no AI code review. The human reviewed behaviour through use.
