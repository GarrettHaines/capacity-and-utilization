import { AppHeader } from "@dynatrace/strato-components-preview";
import { Link, useLocation } from "react-router-dom";
import { MODULES } from "../constants/modules";

/**
 * Dynatrace app header with module nav tabs. Scope and timeframe pickers sit
 * on the individual pages next to the action buttons, not here.
 */
export const Header = () => {
  const location = useLocation();
  const isActive = (path: string) =>
    path === "/" ? location.pathname === "/" : location.pathname.startsWith(path);

  return (
    <AppHeader>
      <AppHeader.NavItems>
        <AppHeader.NavItem as={Link} to="/" isSelected={isActive("/")}>
          Overview
        </AppHeader.NavItem>
        {MODULES.map((m) =>
          m.enabled === false ? (
            <AppHeader.NavItem
              key={m.id}
              as="span"
              aria-disabled="true"
              className="nav-item-disabled"
              title={`${m.shortName} is currently unavailable`}
            >
              {m.shortName}
            </AppHeader.NavItem>
          ) : (
            <AppHeader.NavItem
              key={m.id}
              as={Link}
              to={m.path}
              isSelected={isActive(m.path)}
            >
              {m.shortName}
            </AppHeader.NavItem>
          )
        )}
      </AppHeader.NavItems>
    </AppHeader>
  );
};
