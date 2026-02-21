import { useState } from "react";
import Button from "@mui/material/Button";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import { useNavigate } from "react-router-dom";

interface DropdownItem {
  id: string;
  text: string;
  href?: string;
  external?: boolean;
}

interface RouterButtonDropdownProps {
  items: DropdownItem[];
  children?: React.ReactNode;
  variant?: "text" | "outlined" | "contained";
  onItemClick?: (detail: { id: string }) => void;
}

export default function RouterButtonDropdown({
  items,
  children,
  variant = "text",
  onItemClick,
}: RouterButtonDropdownProps) {
  const navigate = useNavigate();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  const handleItemClick = (item: DropdownItem) => {
    setAnchorEl(null);
    if (onItemClick) {
      onItemClick({ id: item.id });
    }
    if (item.href && !item.external) {
      navigate(item.href);
    } else if (item.href && item.external) {
      window.open(item.href, "_blank");
    }
  };

  return (
    <>
      <Button variant={variant} onClick={(e) => setAnchorEl(e.currentTarget)}>
        {children}
      </Button>
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
      >
        {items.map((item) => (
          <MenuItem key={item.id} onClick={() => handleItemClick(item)}>
            {item.text}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
