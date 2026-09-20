# Kubernetes

Plain manifests for one mAIndmeld instance. Apply them in order, or all at
once with `kubectl apply -k deploy/kubernetes` (a kustomization is included).

Before applying:

1. Edit `configmap.yaml` if you want model profiles; keys are referenced by
   environment variable name and come from the Secret.
2. Edit `secret.yaml` with any provider keys the profiles reference. Do not
   commit real values; use `kubectl create secret generic maindmeld-env
   --from-literal=GEMINI_API_KEY=...` instead of the file if you prefer.
3. Edit `ingress.yaml` with your hostname and TLS issuer, and set
   `MAINDMELD_PUBLIC_ORIGIN` in `deployment.yaml` to the HTTPS origin the
   browser will use. Without it, browser sign-in only works via localhost
   port-forwarding.

Then:

```
kubectl apply -k deploy/kubernetes
kubectl -n maindmeld logs deploy/maindmeld | grep bootstrap   # first-run token
```

Design notes (DESIGN.md 16.3): one replica with the `Recreate` strategy,
because two processes on one data directory would corrupt room files; a
`ReadWriteOnce` volume; the container runs as a non-root user on a
read-only root filesystem with `/data` as its only writable mount. The
sweep (milestone 4) runs from the server's internal scheduler, not a
CronJob, to keep a single writer. Snapshot the volume before upgrades.
