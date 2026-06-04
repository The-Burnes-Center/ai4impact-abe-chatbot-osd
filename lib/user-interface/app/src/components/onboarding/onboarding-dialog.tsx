/**
 * OnboardingDialog — a one-time welcome shown the first time a signed-in user
 * reaches any in-app page. It auto-plays a short walkthrough of asking ABE a
 * question, then never shows again (remembered in localStorage, versioned via
 * StorageHelper so we can re-introduce it after a redesign).
 *
 * Mounted in AppShell, so it covers every authenticated route but not the
 * public landing pages.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import CloseIcon from "@mui/icons-material/Close";
import { StorageHelper } from "../../common/helpers/storage-helper";
import DemoVideo from "./demo-video";

export default function OnboardingDialog() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(() => !StorageHelper.getOnboardingSeen());

  const dismiss = () => {
    StorageHelper.setOnboardingSeen();
    setOpen(false);
  };

  const goToHelp = () => {
    dismiss();
    navigate("/help");
  };

  return (
    <Dialog
      open={open}
      onClose={dismiss}
      maxWidth="sm"
      fullWidth
      aria-labelledby="onboarding-dialog-title"
    >
      <DialogTitle id="onboarding-dialog-title" sx={{ pr: 6 }}>
        Welcome to ABE
        <IconButton
          aria-label="Close"
          onClick={dismiss}
          sx={{ position: "absolute", right: 8, top: 8, color: "text.secondary" }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          ABE is your assistant for Massachusetts procurement. Ask a question in
          plain language and ABE answers using official guidance, with links to
          the sources so you can verify them.
        </DialogContentText>
        <DemoVideo autoPlay />
        <DialogContentText variant="body2" sx={{ mt: 1.5 }}>
          Tip: you can ask follow-up questions, just like a conversation.
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={goToHelp}>View Help &amp; Guide</Button>
        <Button onClick={dismiss} variant="contained">
          Get started
        </Button>
      </DialogActions>
    </Dialog>
  );
}
