import assert from "node:assert/strict";
import test from "node:test";
import { currentGuideStep, getGuideCopy, initialGuideProgress, reconcileGuideProgress, restartGuide, skipGuideStep, type GuideState } from "./guide";
import { getHelpCopy, normalizeLocale } from "./help-registry";

const emptyState: GuideState = {
  repositorySelected: false,
  nodeSelected: false,
  nodeOnline: false,
  variablesConfigured: false,
  deploymentCreated: false,
  deploymentHealthy: false,
  domainAttached: false,
  observabilityOpened: false,
  runtimeOpened: false,
};

test("guide advances from real product state instead of Next clicks", () => {
  let progress = restartGuide();
  assert.equal(currentGuideStep(progress, emptyState)?.id, "github");

  const repositoryState = { ...emptyState, repositorySelected: true };
  progress = reconcileGuideProgress(progress, repositoryState);
  assert.equal(currentGuideStep(progress, repositoryState)?.id, "node");

  const onlineState = { ...repositoryState, nodeSelected: true, nodeOnline: true };
  progress = reconcileGuideProgress(progress, onlineState);
  assert.equal(currentGuideStep(progress, onlineState)?.id, "variables");

  progress = skipGuideStep(progress, "variables");
  assert.equal(currentGuideStep(progress, onlineState)?.id, "deploy");

  const readyState = { ...onlineState, deploymentCreated: true, deploymentHealthy: true };
  progress = reconcileGuideProgress(progress, readyState);
  assert.equal(currentGuideStep(progress, readyState)?.id, "domain");
});

test("guide completion persists independently of later state regression", () => {
  const completed = reconcileGuideProgress(restartGuide(), {
    ...emptyState,
    repositorySelected: true,
    nodeSelected: true,
    nodeOnline: true,
  });
  assert.deepEqual(completed.completed.slice(0, 3), ["github", "node", "readiness"]);
  assert.equal(currentGuideStep(completed, emptyState)?.id, "variables");
});

test("restart resets prior skipped and completed steps", () => {
  const restarted = restartGuide();
  assert.deepEqual(restarted.completed, []);
  assert.deepEqual(restarted.skipped, []);
  assert.equal(restarted.active, true);
  assert.equal(initialGuideProgress.active, false);
});

test("RU and EN help and guide copy are available with locale fallback", () => {
  assert.equal(normalizeLocale("ru-RU"), "ru");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.match(getHelpCopy("ru", "rollback").title, /Откат/);
  assert.match(getHelpCopy("en", "rollback").title, /Rollback/);
  assert.match(getGuideCopy("ru", "deploy").title, /развёртывание/i);
  assert.match(getGuideCopy("en", "deploy").title, /deployment/i);
});
