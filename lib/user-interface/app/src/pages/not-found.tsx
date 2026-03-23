import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import { v4 as uuidv4 } from "uuid";
import { useDocumentTitle } from "../common/hooks/use-document-title";

export default function NotFoundPage() {
  useDocumentTitle("Page not found");

  return (
    <Box sx={{ py: 4, maxWidth: 560 }}>
      <Typography variant="h1" component="h1" gutterBottom sx={{ fontSize: "1.75rem" }}>
        Page not found
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        The address may be mistyped, or the page may have moved. You can start a new chat or open
        the help guide from here.
      </Typography>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
        <Button variant="contained" component={RouterLink} to={`/chatbot/playground/${uuidv4()}`}>
          New chat
        </Button>
        <Button variant="outlined" component={RouterLink} to="/help">
          Help &amp; guide
        </Button>
        <Button variant="text" component={RouterLink} to="/">
          Home
        </Button>
      </Stack>
    </Box>
  );
}
