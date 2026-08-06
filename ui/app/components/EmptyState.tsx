import type { ReactNode } from "react";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph } from "@dynatrace/strato-components/typography";
import { InformationIcon } from "@dynatrace/strato-icons";

export interface EmptyStateProps {
  title: string;
  body?: string;
  icon?: ReactNode;
  action?: ReactNode;
}

/** Shared panel for when the active scope has no relevant entities or findings. */
export const EmptyState = ({ title, body, icon, action }: EmptyStateProps) => (
  <Flex className="empty-state" flexDirection="column" alignItems="center" gap={12}>
    <span className="empty-state-icon">{icon ?? <InformationIcon />}</span>
    <Heading level={5} className="empty-state-title">
      {title}
    </Heading>
    {body && <Paragraph className="empty-state-body">{body}</Paragraph>}
    {action}
  </Flex>
);
