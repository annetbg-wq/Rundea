import { AsyncLocalStorage } from "node:async_hooks";

export type StaticTokenOperationActor = Readonly<{
  authenticationMethod: "STATIC_TOKEN";
  issuer: null;
  subject: null;
  scopes: readonly string[];
}>;

export type OAuthOperationActor = Readonly<{
  authenticationMethod: "OAUTH";
  issuer: string;
  subject: string;
  scopes: readonly string[];
}>;

export type OperationActor = StaticTokenOperationActor | OAuthOperationActor;

export const staticTokenOperationActor: StaticTokenOperationActor = Object.freeze({
  authenticationMethod: "STATIC_TOKEN",
  issuer: null,
  subject: null,
  scopes: Object.freeze([] as string[]),
});

export class OperationActorContext {
  private readonly storage = new AsyncLocalStorage<OperationActor>();

  current(): OperationActor | undefined {
    return this.storage.getStore();
  }

  run<Result>(actor: OperationActor, callback: () => Result): Result {
    return this.storage.run(actor, callback);
  }
}
