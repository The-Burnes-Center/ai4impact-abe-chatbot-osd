import { Chip, CircularProgress } from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";

export type StatusVariant = "ready" | "processing" | "error" | "empty";

const config: Record<
  StatusVariant,
  { color: "success" | "warning" | "error" | "default"; icon: React.ReactElement }
> = {
  ready: { color: "success", icon: <CheckCircleOutlineIcon fontSize="small" /> },
  processing: { color: "warning", icon: <CircularProgress size={14} color="inherit" /> },
  error: { color: "error", icon: <ErrorOutlineIcon fontSize="small" /> },
  empty: { color: "default", icon: <RemoveCircleOutlineIcon fontSize="small" /> },
};

interface StatusChipProps {
  status: StatusVariant;
  label: string;
}

export default function StatusChip({ status, label }: StatusChipProps) {
  const { color, icon } = config[status];
  return (
    <Chip
      size="small"
      variant="outlined"
      color={color}
      icon={icon}
      label={label}
      sx={{ fontWeight: 500 }}
    />
  );
}
