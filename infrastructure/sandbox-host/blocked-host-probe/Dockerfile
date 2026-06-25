# blocked-host-probe - the TRUSTED operator probe image (SBX-02/06, PRX-02).
#
# This image is an operator tool, NOT untrusted handler code. The deployer's
# runEgressProbe launches it on the handler's pairnet (NetworkMode: the pairnet
# name - the same internal bridge, no gateway, so the same reachability as the
# handler) so a single TCP connect from this image tests the HANDLER's real
# reachability of a blocked host. It exits 0 if the
# target is reachable (a CONTAINMENT FAILURE) and non-zero if the connect is
# refused / times out (the blocked-OK outcome the acceptance wants).
#
# The target host (and optional port) ride in the container's Cmd args, NOT the
# image tag and NOT the env: the untrusted RunSpec is locked (empty env, no cmd),
# so a dynamic target cannot pass through it. This image is launched directly via
# dockerode by the trusted host caller, so it takes its target on the command line.
#
# Build (operator, on the provisioned host):
#   docker build -t utter/blocked-host-probe:latest infrastructure/sandbox-host/blocked-host-probe
FROM alpine:3.20

# busybox `nc` (BusyBox netcat) ships in the base alpine image; no extra install
# is needed. The entrypoint is the only added artifact.
COPY probe.sh /usr/local/bin/probe.sh
RUN chmod +x /usr/local/bin/probe.sh

# The image is readonly-friendly: it writes nothing, reads no secret, and runs a
# single short-timeout connect. ENTRYPOINT takes the target host as $1 and an
# optional port as $2 (default 80).
ENTRYPOINT ["/usr/local/bin/probe.sh"]
