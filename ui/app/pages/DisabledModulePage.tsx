import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph } from "@dynatrace/strato-components/typography";
import { EmptyState } from "../components/EmptyState";
import { MODULE_BY_ID } from "../constants/modules";
import type { ModuleId } from "../types/types";

export interface DisabledModulePageProps {
  module: ModuleId;
}

/**
 * Placeholder for modules that are switched off (Kubernetes, Scaling). Their nav
 * tab is greyed out, but a bookmark or direct URL still lands here.
 */
export const DisabledModulePage = ({ module }: DisabledModulePageProps) => {
  const config = MODULE_BY_ID[module];
  return (
    <Flex flexDirection="column" gap={16} className="page-container">
      <div className="page-header-row">
        <div className="page-title-block">
          <Heading level={3} className="text-subdued">
            {config.name}
          </Heading>
          <Paragraph className="page-subtitle">{config.description}</Paragraph>
        </div>
      </div>
      <EmptyState
        title={`${config.shortName} is currently unavailable`}
        body="This page is turned off in this build. Compute and Disk are the active pages."
      />
    </Flex>
  );
};
