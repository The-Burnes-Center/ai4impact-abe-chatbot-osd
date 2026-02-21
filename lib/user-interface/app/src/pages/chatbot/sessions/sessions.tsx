import Sessions from "../../../components/chatbot/sessions";
import Breadcrumbs from "@mui/material/Breadcrumbs";
import MuiLink from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { Link as RouterLink } from "react-router-dom";
import { CHATBOT_NAME } from "../../../common/constants";

export default function SessionPage() {
  return (
    <>
      <Breadcrumbs sx={{ mb: 2 }}>
        <MuiLink component={RouterLink} to="/" underline="hover" color="inherit">
          {CHATBOT_NAME}
        </MuiLink>
        <Typography color="text.primary">Sessions</Typography>
      </Breadcrumbs>
      <Sessions toolsOpen={true} />
    </>
  );
}
