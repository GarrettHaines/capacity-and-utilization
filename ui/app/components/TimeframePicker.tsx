import { TimeframeSelector } from "@dynatrace/strato-components-preview/filters";
import { Flex } from "@dynatrace/strato-components/layouts";
import { ClockIcon } from "@dynatrace/strato-icons";
import { useScope } from "../contexts/ScopeContext";
import { TIMEFRAME_SHOW_STEPPER } from "../constants/ui-toggles";

/**
 * Strato TimeframeSelector with a clock icon at the left of the default
 * trigger. The Trigger + DisplayValue render-prop child keeps Strato's
 * formatted label ("Last 7 days") and dropdown chevron; only the icon is
 * custom.
 *
 * TIMEFRAME_SHOW_STEPPER in constants/ui-toggles.ts toggles the prev/next
 * arrows that flank the trigger.
 */
export const TimeframePicker = () => {
  const { timeframe, setTimeframe } = useScope();

  return (
    <TimeframeSelector
      aria-label="Timeframe"
      stepper={TIMEFRAME_SHOW_STEPPER}
      value={{ from: timeframe.from, to: timeframe.to }}
      onChange={(tf) => {
        if (!tf) return;
        setTimeframe({
          // Fallback matches the app-wide cold-start default; a partial event
          // from Strato must not silently restore a 7-day window.
          from: tf.from?.value ?? "now-2h",
          to: tf.to?.value ?? "now",
        });
      }}
    >
      <TimeframeSelector.Trigger>
        <TimeframeSelector.DisplayValue>
          {({ displayValue }) => (
            <Flex gap={6} alignItems="center">
              <ClockIcon />
              {displayValue}
            </Flex>
          )}
        </TimeframeSelector.DisplayValue>
      </TimeframeSelector.Trigger>
    </TimeframeSelector>
  );
};
