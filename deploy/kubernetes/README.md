<img src="../../src/web/logo.svg" alt="" width="32" height="32" align="left">

# Kubernetes

Plain manifests for one mAIndmeld instance: a controller-neutral base and
one overlay per ingress controller. Apply an overlay, never the base alone,
unless you bring your own route.

```
deploy/kubernetes/
  base/               namespace, configmap, secret, pvc, deployment, service
  overlays/nginx/     ingress-nginx Ingress with cert-manager annotations
  overlays/traefik/   Traefik IngressRoute with a certResolver
```

Before applying:

1. Pick the overlay for your controller and edit its hostname and issuer
   or resolver. For anything else, copy an overlay and replace the route
   resource; the base does not change.
2. Set `MAINDMELD_PUBLIC_ORIGIN` in `base/deployment.yaml` to the HTTPS
   origin browsers will use. Sign-in and CSRF checks depend on it; without
   it, browser sign-in only works via localhost port-forwarding.
3. Check the image reference in `base/deployment.yaml`. It points at the
   published `ghcr.io/dev-dull/maindmeld` image, pinned by digest so a
   re-pushed tag cannot change what runs. To move to a newer release,
   replace both the tag and the digest, which `docker buildx imagetools
   inspect ghcr.io/dev-dull/maindmeld:<tag>` prints. To build your own,
   use the repo's Dockerfile and push to a registry your nodes pull from.
4. Optionally add model profiles to `base/configmap.yaml`; keys are named
   by environment variable and come from `base/secret.yaml`. The Secret
   may be empty, but it must exist because the Deployment references it.
5. Add a notifier to `base/configmap.yaml` (an example is in the file's
   comments) and its secret to `base/secret.yaml`. Without one, a carried
   call-a-human motion reaches nobody but an open browser tab.
6. If your storage has no default class, set `storageClassName` in
   `base/pvc.yaml`.

Then:

```
kubectl apply -k deploy/kubernetes/overlays/traefik
kubectl -n maindmeld logs deploy/maindmeld | grep bootstrap   # first-run token
```

## The runner

The base also deploys a runner (`runner-deployment.yaml`) from the
`maindmeld-runner` image, which carries Claude Code and OpenCode. It reads
`runner-configmap.yaml`, reaches the server through its Service, and takes
its token and the harnesses' provider keys from the `maindmeld-runner-env`
Secret (`runner-secret.yaml` holds placeholders; replace them or manage
the Secret out of band and drop the file from the kustomization). Mint the
token with `token create runner-cluster`. The runner is unprivileged, has
no Docker socket, and starts harnesses as processes in its own pod;
sandboxing beyond that is yours. If you do not want a runner, remove the
three runner files from `base/kustomization.yaml` in your own overlay.

## Tokens

The first start with no tokens prints one named `bootstrap`. Use it once
to mint a named token per consumer, then revoke it, so rate limits and
statistics stay attributable:

```
kubectl -n maindmeld exec deploy/maindmeld -- node bin/maindmeld.js token create homelab
kubectl -n maindmeld exec deploy/maindmeld -- node bin/maindmeld.js token revoke bootstrap
```

## Upgrading

The Deployment uses the `Recreate` strategy, so an upgrade stops the old
pod before the new one starts: expect a short outage while the image
pulls and the pod passes its readiness probe. Room state, tokens, and the
knowledge store live on the volume, so nothing in flight is lost; an
agent mid-`room_listen` gets a connection error and reconnects.

Before every upgrade, snapshot the volume. Use a CSI `VolumeSnapshot`
where the storage class supports it; otherwise snapshot on the storage
side (a ZFS or NFS-server snapshot of the backing dataset) and note the
name against the version you are leaving. Then change the tag and digest
in `base/deployment.yaml`, apply, and confirm `GET /api/health` reports
the new version.

## GitOps

The overlays are plain kustomize, so Argo CD or Flux can reconcile one
directly. Keep site-specific patches (hostname, public origin, storage
class, the real config) in a kustomization of your own that lists this
repo's overlay as a resource, and point the controller at that; the base
and overlays then update by changing the repo ref. Whatever reconciles
the deployment must not also manage the Secret's contents if an operator
such as External Secrets already does.

## Proxy timeouts

Long-poll requests can last up to 300 s and SSE streams stay open
indefinitely, so the proxy in front of the pod needs a read timeout of at
least 600 s. The nginx overlay sets that with annotations; Traefik sets it
on the entrypoint, so the overlay carries no timeout.

## Design notes

See DESIGN.md 16.3: one replica with the `Recreate` strategy,
because two processes on one data directory would corrupt room files; a
`ReadWriteOnce` volume; the container runs as a non-root user on a
read-only root filesystem with `/data` as its only writable mount. The
sweep (milestone 6) runs from the server's internal scheduler, not a
CronJob, to keep a single writer. Snapshot the volume before upgrades.
