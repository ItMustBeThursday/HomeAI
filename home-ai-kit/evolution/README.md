# HomeAI evolution

Local development kit: deterministic switch/voice/model policy, manifest-driven Node tests/builds, loopback serving, and a speech-aware switch lab.

From this directory:

```powershell
node run-kit.mjs test runner.example.json
node run-kit.mjs serve simulator.manifest.json --allow-build --allow-serve
```

Open **http://127.0.0.1:18764/**. Use Ctrl+C to stop foreground serving. A local browser voice is required for audio mode; missing voices pause. Caregivers can disable audio for visual-only testing.

See [STATUS.md](STATUS.md), [CURRENT-RUNBOOK.md](CURRENT-RUNBOOK.md) and [RELEASE-EVIDENCE.json](RELEASE-EVIDENCE.json). The preserved earlier independent review predates the finishing changes.

Pi/physical switches, Home Assistant, real audio and caregiver/accessibility trials are **not certified or connected** by this release. Video remains deferred.
