import { useCallback } from "react";
import { useNavigate } from "react-router";

interface FollowDetail {
  external?: boolean;
  href?: string;
}

export default function useOnFollow() {
  const navigate = useNavigate();

  return useCallback(
    (event: CustomEvent<FollowDetail>): void => {
      if (
        event.detail.external === true ||
        typeof event.detail.href === "undefined"
      ) {
        return;
      }

      event.preventDefault();
      
      // Special handling for hash navigation to prevent duplicate paths
      const href = event.detail.href;
      if (href && href.includes('#')) {
        const [path, hash] = href.split('#');
        if (window.location.pathname === path) {
          // If already on the right path, just update the hash
          navigate(`${path}#${hash}`, { replace: true });
          return;
        }
      }
      
      // Regular navigation
      navigate(event.detail.href);
    },
    [navigate]
  );
}
