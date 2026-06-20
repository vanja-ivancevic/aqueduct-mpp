/**
 * ComputeProvider — the seam between the Tap server and WHERE it runs.
 *
 * The server is one container image; a provider renders the deployment manifest for a target. Today
 * the only target is `local` (docker-compose); permissionless hosting (e.g. Akash) is a future goal,
 * not yet tested. Providers are pure renderers: they turn a `DeploySpec` into a manifest string +
 * operator notes — they never hold secrets or broadcast anything. Actual `docker compose up` steps are
 * the operator's, listed in `notes`.
 */

export type DeploySpec = {
  /** Container image reference the target will run (e.g. ghcr.io/you/aqueduct:latest). */
  image: string;
  /** Port the server listens on (also the externally exposed port). */
  port: number;
  /** Dataset baked into the image that the container onboards (deterministically) + serves at boot. */
  dataset: string;
  cpu: number;
  memory: string;
  storage: string;
};

export type DeployArtifact = {
  /** Suggested output filename for the rendered manifest. */
  filename: string;
  /** The manifest contents. */
  content: string;
  /** Operator next-steps (env to set, CLI commands) printed after rendering. */
  notes: string[];
};

export interface ComputeProvider {
  readonly target: "local";
  render(spec: DeploySpec): DeployArtifact;
}

export const DEFAULT_SPEC: Omit<DeploySpec, "image"> = {
  port: 8402,
  dataset: "examples/doaj-journals.csv",
  cpu: 0.5,
  memory: "512Mi",
  storage: "1Gi",
};
