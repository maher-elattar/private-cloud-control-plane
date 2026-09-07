# The in-cluster Git repository server.
#
# `alpine/git` does not ship `git-daemon` — Alpine packages it separately — so the container that
# has Git and the container that can serve it are not the same image upstream. This adds the one
# missing package to a base that is already tiny, and is used for both the init container that
# builds the repository and the container that serves it.
#
# WHY the Git protocol rather than HTTP: Argo CD's repository server lists refs with go-git, which
# implements only the smart transports. A static HTTP server answers a dumb-HTTP clone correctly
# and fails go-git's `ls-remote` with "unexpected EOF", which reads as a corrupt repository rather
# than an unsupported transport.
#
# Read-only by construction: `git daemon` does not enable `receive-pack` unless asked, and it is
# not asked. Content changes only by republish, which rebuilds the repository from scratch.
FROM alpine:3.22.2

RUN apk add --no-cache git=2.49.1-r0 git-daemon=2.49.1-r0 \
  && mkdir -p /srv/git \
  && chown 65532:65532 /srv/git

USER 65532:65532
EXPOSE 9418
