import MuiLink, { LinkProps as MuiLinkProps } from "@mui/material/Link";
import { Link as RouterDomLink } from "react-router-dom";

interface RouterLinkProps extends MuiLinkProps {
  href?: string;
  external?: boolean;
}

export default function RouterLink({ href, external, children, ...rest }: RouterLinkProps) {
  if (external || !href) {
    return (
      <MuiLink href={href} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </MuiLink>
    );
  }

  return (
    <MuiLink component={RouterDomLink} to={href} {...rest}>
      {children}
    </MuiLink>
  );
}
