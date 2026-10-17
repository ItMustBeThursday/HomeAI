# Companion source snapshot

Desktop, Android and remote proxy source retained for the pending orchestrator API migration. These clients still use the legacy gateway protocol; they are not current orchestrator clients. Preserve existing deployments until approved cutover.

This snapshot excludes family credentials, provisioning assets, local SDK paths, signing keys, generated bundles, dependency trees, build output and captured conversations. Configure private credentials locally. Do not commit them. Desktop rendering bundles must be rebuilt from source before packaging. Android uses the local SDK/JDK/Gradle installations.

Offline checks: `node --test test/*.test.mjs` in desktop; `node --test logic.test.mjs` in remote; Gradle `--offline :app:testDebugUnitTest :app:lintDebug` in Android with a configured local SDK. None of these checks establishes live end-to-end migration.
