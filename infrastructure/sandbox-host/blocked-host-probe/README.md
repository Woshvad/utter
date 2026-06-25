# blocked-host-probe

The TRUSTED operator probe image for the egress / containment acceptances
(SBX-02/06, PRX-02). It is an operator tool, not untrusted handler code.

## What it does

Given a target host (and optional port, default 80) as command-line args, it
attempts a short-timeout TCP connect with BusyBox `nc` and:

- exits `0` if the host is **reachable** (a containment FAILURE the caller surfaces), and
- exits **non-zero** if the connect is refused / times out (the blocked-OK outcome).

The deployer's `runEgressProbe` (services/deployer/src/live-deploy.ts) launches
this image directly via dockerode inside the handler's network namespace
(`NetworkMode: container:<handlerName>`), so the connect tests the HANDLER's real
reachability of a blocked host. The target rides in the container `Cmd` args, not
the image tag and not the env: the untrusted `RunSpec` is locked (empty env, no
cmd), so a dynamic target cannot pass through it.

## Build

```
docker build -t utter/blocked-host-probe:latest infrastructure/sandbox-host/blocked-host-probe
```

Build it on the provisioned gVisor host as part of `infrastructure/RUNBOOK.md`,
before running the live egress probe (`UTTER_RUN_EGRESS_PROBE=1`).

## Host validation required

The end-to-end probe run (launching this image in the handler netns and asserting
every blocked host is unreachable) is NOT validated in the autonomous suite - it
needs the provisioned gVisor host. The autonomous suite only verifies the
construction logic (a valid image reference, the target in `Cmd`, and the handler
netns) via a docker stub.
