import { forwardRef } from "react";
import Button, { ButtonProps } from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import { Link as RouterLink } from "react-router-dom";

interface RouterButtonProps extends Omit<ButtonProps, "href"> {
  href?: string;
  loading?: boolean;
  iconSvg?: React.ReactNode;
}

const RouterButton = forwardRef<HTMLButtonElement, RouterButtonProps>(
  function RouterButton({ href, loading, iconSvg, children, disabled, ...rest }, ref) {
    const linkProps = href
      ? { component: RouterLink as any, to: href }
      : {};

    return (
      <Button
        ref={ref}
        disabled={disabled || loading}
        startIcon={loading ? <CircularProgress size={16} color="inherit" /> : iconSvg}
        {...linkProps}
        {...rest}
      >
        {children}
      </Button>
    );
  }
);

export default RouterButton;
