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
3. Set the image reference in `base/deployment.yaml`. Build from the
   repo's Dockerfile for your nodes' architecture and push to a registry
   your cluster pulls from; nothing is published to a public registry yet.
4. Optionally add model profiles to `base/configmap.yaml`; keys are named
   by environment variable and come from `base/secret.yaml`. The Secret
   may be empty, but it must exist because the Deployment references it.
5. If your storage has no default class, set `storageClassName` in
   `base/pvc.yaml`.

Then:

```
kubectl apply -k deploy/kubernetes/overlays/traefik
kubectl -n maindmeld logs deploy/maindmeld | grep bootstrap   # first-run token
```

Proxy timeouts: long-poll requests can last up to 300 s and SSE streams
stay open indefinitely, so the proxy in front of the pod needs a read
timeout of at least 600 s. The nginx overlay sets that with annotations;
Traefik sets it on the entrypoint, so the overlay carries no timeout.

Design notes (DESIGN.md 16.3): one replica with the `Recreate` strategy,
because two processes on one data directory would corrupt room files; a
`ReadWriteOnce` volume; the container runs as a non-root user on a
read-only root filesystem with `/data` as its only writable mount. The
sweep (milestone 6) runs from the server's internal scheduler, not a
CronJob, to keep a single writer. Snapshot the volume before upgrades.
