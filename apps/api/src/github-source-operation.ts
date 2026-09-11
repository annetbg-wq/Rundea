import type { OperationActor } from "./operation-actor";
import type { OperationAuditRecorder } from "./operation-audit";
import { executeAuthorizedOperation, type OperationExecutionResult } from "./operation-execution";
import {
  discoverGitHubSource,
  type GitHubRepositoryReader,
  type GitHubSourceDiscoveryProfile,
} from "./github-source-discovery";

export class GitHubSourceDiscoveryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubSourceDiscoveryInputError";
  }
}

const repoPartPattern = /^[A-Za-z0-9_.-]+$/;

export type GitHubSourceDiscoveryInput = Readonly<{
  repositoryFullName: string;
  ref?: string;
}>;

export type GitHubSourceDiscoveryDependencies = Readonly<{
  reader: GitHubRepositoryReader;
  audit: OperationAuditRecorder;
  actor?: OperationActor;
}>;

function normalizeRepositoryFullName(value: string): string {
  const parts = value.trim().split("/");
  if (parts.length !== 2 || !repoPartPattern.test(parts[0] ?? "") || !repoPartPattern.test(parts[1] ?? "")) {
    throw new GitHubSourceDiscoveryInputError("repositoryFullName must be owner/repository");
  }
  return `${parts[0]}/${parts[1]}`;
}

function normalizeRef(value: string | undefined): string | undefined {
  const ref = value?.trim();
  if (!ref) return undefined;
  if (ref.length > 256 || /[\r\n\u0000]/.test(ref)) throw new GitHubSourceDiscoveryInputError("ref is invalid");
  return ref;
}

function neverResolveApproval(): Promise<null> {
  throw new Error("read-only GitHub source discovery attempted to resolve approval state");
}

function neverConsumeApproval(): Promise<boolean> {
  throw new Error("read-only GitHub source discovery attempted to consume approval state");
}

export async function executeGitHubSourceDiscoveryOperation(
  dependencies: GitHubSourceDiscoveryDependencies,
  input: GitHubSourceDiscoveryInput,
): Promise<OperationExecutionResult<GitHubSourceDiscoveryProfile>> {
  const repositoryFullName = normalizeRepositoryFullName(input.repositoryFullName);
  const ref = normalizeRef(input.ref);
  const resourceSuffix = ref ?? "default";

  return executeAuthorizedOperation(
    {
      operationName: "source.github.discover",
      client: "API",
      resourceId: `source:github:${repositoryFullName}@${resourceSuffix}`,
      actor: dependencies.actor,
    },
    neverResolveApproval,
    neverConsumeApproval,
    dependencies.audit,
    async () => discoverGitHubSource(dependencies.reader, repositoryFullName, ref),
  );
}
