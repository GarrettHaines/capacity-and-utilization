import { useEffect, useState } from "react";
import { ConfirmDiscardModal } from "./ConfirmDiscardModal";
import { deepEqual } from "../utils/merge";
import { Modal } from "@dynatrace/strato-components-preview/overlays";
import {
  Label,
  Switch,
  TextInput,
  ToggleButtonGroup,
} from "@dynatrace/strato-components-preview/forms";
import { Button } from "@dynatrace/strato-components/buttons";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph } from "@dynatrace/strato-components/typography";
import type {
  DataResolution,
  FilterScope,
  HostNameSource,
} from "../types/types";
import { useScope } from "../contexts/ScopeContext";
import { formatDateTime } from "../utils/helpers";

/**
 * Settings that apply to every page. With snooze off there is no snooze
 * surface anywhere (recent-activity card, Show-snoozed filter, details-modal
 * actions). Saving a team default publishes the whole setup (scope, timeframe,
 * host filter, columns, thresholds, settings) as the seed for new users.
 */
export const AppSettingsModal = ({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) => {
  const {
    appSettings,
    setAppSettings,
    orgDefaults,
    saveCurrentSetupAsDefault,
    resetSettingsOnly,
    resetAllToDefaults,
    canManageTeamDefault,
    resetTeamDefaultToAppDefaults,
  } = useScope();
  const [hostNameSource, setHostNameSource] =
    useState<HostNameSource>("displayName");
  const [filterScope, setFilterScope] = useState<FilterScope>("module");
  // Snooze stays in the model so a team default can enable it; its UI is hidden.
  const [snoozeEnabled, setSnoozeEnabled] = useState(false);
  const [windowDays, setWindowDays] = useState(14);
  const [resourceWindowSync, setResourceWindowSync] = useState(false);
  const [dataResolution, setDataResolution] = useState<DataResolution>("balanced");
  const [hideFilterFields, setHideFilterFields] = useState(true);
  const [showMzFilter, setShowMzFilter] = useState(false);
  const [hideOffline, setHideOffline] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  const [savedDefault, setSavedDefault] = useState(false);
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const [confirmResetTeam, setConfirmResetTeam] = useState(false);
  const [resettingTeam, setResettingTeam] = useState(false);

  useEffect(() => {
    if (!open) return;
    setHostNameSource(appSettings.hostNameSource);
    setFilterScope(appSettings.filterScope);
    setSnoozeEnabled(appSettings.snoozeEnabled);
    setWindowDays(appSettings.windowDays);
    setResourceWindowSync(appSettings.resourceWindowSync);
    setDataResolution(appSettings.dataResolution);
    setHideFilterFields(appSettings.hideFilterForHiddenColumns);
    setShowMzFilter(appSettings.showManagementZoneFilter);
    setHideOffline(appSettings.hideOfflineHosts);
    setSavingDefault(false);
    setSavedDefault(false);
    setConfirmResetAll(false);
    setConfirmResetTeam(false);
    setResettingTeam(false);
    setConfirmDiscard(false);
  }, [open, appSettings]);

  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const draft = {
    ...appSettings,
    hostNameSource,
    filterScope,
    snoozeEnabled,
    windowDays,
    resourceWindowSync,
    dataResolution,
    hideFilterForHiddenColumns: hideFilterFields,
    showManagementZoneFilter: showMzFilter,
    hideOfflineHosts: hideOffline,
  };

  const save = () => {
    setAppSettings(draft);
    onClose();
  };

  const dirty = !deepEqual(draft, appSettings);

  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const handleSaveDefault = async () => {
    setSavingDefault(true);
    setSavedDefault(false);
    try {
      // Publishes the unsaved draft, so edits made in this modal are included.
      await saveCurrentSetupAsDefault(draft);
      setSavedDefault(true);
    } catch (err) {
      console.error("Failed to save team default", err);
    } finally {
      setSavingDefault(false);
    }
  };

  // Two-click confirm: this changes what every user falls back to.
  const handleResetTeamDefault = async () => {
    if (!confirmResetTeam) {
      setConfirmResetTeam(true);
      return;
    }
    setResettingTeam(true);
    try {
      await resetTeamDefaultToAppDefaults();
    } catch (err) {
      console.error("Failed to reset team default", err);
    } finally {
      setResettingTeam(false);
      setConfirmResetTeam(false);
    }
  };

  // The open-effect re-seeds the local fields from the reset values.
  const handleResetSettings = () => {
    resetSettingsOnly();
  };

  // Two-click confirm: clears every personal customization (filters, columns,
  // settings) and snaps view state back to the team default.
  const handleResetAll = async () => {
    if (!confirmResetAll) {
      setConfirmResetAll(true);
      return;
    }
    try {
      await resetAllToDefaults();
    } catch (err) {
      console.error("Failed to reset all to defaults", err);
    } finally {
      setConfirmResetAll(false);
      onClose();
    }
  };

  return (
    <>
    <Modal show={open} onDismiss={requestClose} title="Settings" size="medium">
      <div className="modal-body">
        <Flex flexDirection="column" gap={12}>
          <div className="filter-section">
            <Heading level={6}>Measurement window</Heading>
            <Paragraph className="text-secondary">
              How far back the numbers are measured, for both the disk fill trend
              ("Full in" / "Daily Δ%") and the usage stats (CPU, memory, and disk
              IOPS min / avg / median / P95 / max). The page timeframe still
              controls what's visible; this controls how far back it looks.
            </Paragraph>
            <Flex flexDirection="column" gap={4}>
              <Label>Days</Label>
              <div className="rule-pattern-input">
                <TextInput
                  value={String(windowDays ?? "")}
                  onChange={(v) => {
                    const n = Number(String(v ?? ""));
                    if (Number.isFinite(n)) setWindowDays(n);
                  }}
                />
              </div>
            </Flex>
            <Flex gap={8} alignItems="center">
              <Switch
                value={resourceWindowSync}
                onChange={(v) => setResourceWindowSync(Boolean(v))}
              />
              <Paragraph>Match the page timeframe for usage stats</Paragraph>
            </Flex>
            <Paragraph className="text-subdued">
              When on, the usage stats cover exactly the page timeframe instead of
              the window above. The disk fill trend always uses the window above,
              since a projection needs a stable baseline.
            </Paragraph>
          </div>

          <div className="filter-section">
            <Heading level={6}>Host names</Heading>
            <Paragraph className="text-secondary">
              How host names are shown. "Detected name" is what the OneAgent
              detected on the host; "Display name" is the Dynatrace entity name.
              Applies to all pages.
            </Paragraph>
            <ToggleButtonGroup
              value={hostNameSource}
              onChange={(v) =>
                setHostNameSource(v === "detected" ? "detected" : "displayName")
              }
            >
              <ToggleButtonGroup.Item value="displayName">
                Display name
              </ToggleButtonGroup.Item>
              <ToggleButtonGroup.Item value="detected">
                Detected name
              </ToggleButtonGroup.Item>
            </ToggleButtonGroup>
          </div>

          <div className="filter-section">
            <Heading level={6}>Filter scope</Heading>
            <Paragraph className="text-secondary">
              How widely the Filters menu applies. "All pages" uses one filter
              everywhere (and shows a Filters button on the Overview). "Per page"
              shares one filter across a page's tabs (e.g. the disk page's High,
              Low, and Normal), kept separate from other pages. "Per tab" gives
              each tab its own filter.
            </Paragraph>
            <ToggleButtonGroup
              value={filterScope}
              onChange={(v) =>
                setFilterScope(
                  v === "app" || v === "view" ? (v as FilterScope) : "module"
                )
              }
            >
              <ToggleButtonGroup.Item value="app">All pages</ToggleButtonGroup.Item>
              <ToggleButtonGroup.Item value="module">Per page</ToggleButtonGroup.Item>
              <ToggleButtonGroup.Item value="view">Per tab</ToggleButtonGroup.Item>
            </ToggleButtonGroup>
          </div>

          <div className="filter-section">
            <Heading level={6}>Data resolution</Heading>
            <Paragraph className="text-secondary">
              Trades accuracy for speed on live queries. Lower resolution uses a
              coarser interval, so refreshes are faster but peaks are smoothed:
              P95 and max read lower and brief spikes can be missed. "Balanced"
              is the standard setting; "Fast" helps most on large environments.
              This affects live refreshes only, not cached results.
            </Paragraph>
            <ToggleButtonGroup
              value={dataResolution}
              onChange={(v) =>
                setDataResolution(
                  v === "high" || v === "fast" ? (v as DataResolution) : "balanced"
                )
              }
            >
              <ToggleButtonGroup.Item value="high">High</ToggleButtonGroup.Item>
              <ToggleButtonGroup.Item value="balanced">Balanced</ToggleButtonGroup.Item>
              <ToggleButtonGroup.Item value="fast">Fast</ToggleButtonGroup.Item>
            </ToggleButtonGroup>
          </div>

          <div className="filter-section">
            <Heading level={6}>Filter fields</Heading>
            <Paragraph className="text-secondary">
              Off by default: hiding a column on a tab also hides its field in
              that tab's filter, so the filter only shows what you're looking at.
              Turn on to always show a field for every column, even hidden ones.
            </Paragraph>
            <div className="filter-checkbox-row">
              <Switch
                value={!hideFilterFields}
                onChange={(next) => setHideFilterFields(!Boolean(next))}
              >
                Show fields of hidden columns in the filter
              </Switch>
            </div>
          </div>

          <div className="filter-section">
            <Heading level={6}>Scope dropdown</Heading>
            <Paragraph className="text-secondary">
              Off by default, so everyone works across all hosts. Turn this on to
              show the toolbar dropdown that narrows findings to a management zone
              or segment.
            </Paragraph>
            <div className="filter-checkbox-row">
              <Switch
                value={showMzFilter}
                onChange={(next) => setShowMzFilter(Boolean(next))}
              >
                Show the scope dropdown
              </Switch>
            </div>
          </div>

          <div className="filter-section">
            <Heading level={6}>Offline hosts</Heading>
            <Paragraph className="text-secondary">
              Off by default: hosts that aren't currently reporting still show,
              dimmed with an "offline" badge. Turn on to hide them from findings
              entirely.
            </Paragraph>
            <div className="filter-checkbox-row">
              <Switch
                value={hideOffline}
                onChange={(next) => setHideOffline(Boolean(next))}
              >
                Hide hosts that are currently offline
              </Switch>
            </div>
          </div>

          {/* Snooze & acknowledge: hidden UI. The setting stays in the model so
              a team default can enable it. Uncomment to surface it here.
          <div className="filter-section">
            <Heading level={6}>Snooze &amp; acknowledge</Heading>
            <Paragraph className="text-secondary">
              Adds snooze and acknowledge actions on findings, the homepage
              recent-activity card, and the Show snoozed filter.
            </Paragraph>
            <div className="filter-checkbox-row">
              <Switch
                value={snoozeEnabled}
                onChange={(next) => setSnoozeEnabled(Boolean(next))}
              >
                Enable snooze &amp; acknowledge
              </Switch>
            </div>
          </div>
          */}

          <div className="filter-section">
            <Heading level={6}>Team default</Heading>
            <Paragraph className="text-secondary">
              Save your current scope, timeframe, host filter, columns, filter
              thresholds, and settings as the team default. New users start from
              it, and existing users pick it up for anything they haven't
              changed. Personal customizations stay untouched until reset. "Reset
              saved team default" puts the team back on the app's built-in
              defaults. Both are admin-only.
            </Paragraph>
            {orgDefaults?.updatedBy && (
              <Paragraph className="text-subdued">
                Current default set by {orgDefaults.updatedBy}
                {orgDefaults.updatedAt
                  ? ` on ${formatDateTime(orgDefaults.updatedAt)}`
                  : ""}
                .
              </Paragraph>
            )}
            {canManageTeamDefault ? (
              <Flex gap={8}>
                <Button
                  variant="emphasized"
                  onClick={handleSaveDefault}
                  disabled={savingDefault || resettingTeam}
                >
                  {savingDefault
                    ? "Saving…"
                    : savedDefault
                    ? "Saved as team default ✓"
                    : "Save current setup as team default"}
                </Button>
                <Button
                  variant="emphasized"
                  onClick={handleResetTeamDefault}
                  disabled={savingDefault || resettingTeam}
                >
                  {resettingTeam
                    ? "Resetting…"
                    : confirmResetTeam
                    ? "Click again to confirm reset"
                    : "Reset saved team default"}
                </Button>
              </Flex>
            ) : (
              <Paragraph className="text-subdued">
                The team default is managed by admins.
              </Paragraph>
            )}
          </div>

          <div className="filter-section">
            <Heading level={6}>Reset</Heading>
            <Paragraph className="text-secondary">
              "Reset settings to defaults" clears only the options above (host
              names, offline, forecasting, filter fields) and restores the team
              default. "Reset all to defaults" clears every personal
              customization across the app (filters, columns, settings) and
              restores the team default everywhere.
            </Paragraph>
            <Flex gap={8}>
              <Button variant="emphasized" onClick={handleResetSettings}>
                Reset settings to defaults
              </Button>
              <Button variant="emphasized" onClick={handleResetAll}>
                {confirmResetAll
                  ? "Click again to confirm reset"
                  : "Reset all to defaults"}
              </Button>
            </Flex>
          </div>
        </Flex>
      </div>

      <Flex className="modal-footer" gap={8}>
        <Button variant="emphasized" onClick={requestClose}>
          Cancel
        </Button>
        <Button variant="accent" color="primary" onClick={save}>
          Save
        </Button>
      </Flex>
    </Modal>
    <ConfirmDiscardModal
      open={confirmDiscard}
      onKeepEditing={() => setConfirmDiscard(false)}
      onDiscard={() => {
        setConfirmDiscard(false);
        onClose();
      }}
    />
    </>
  );
};
