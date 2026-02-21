import Typography from "@mui/material/Typography";
import Stack from "@mui/material/Stack";
import Paper from "@mui/material/Paper";
import Box from "@mui/material/Box";

export default function Support() {
  return (
    <Box role="main">
      <Typography variant="h2" component="h1" gutterBottom>
        Support
      </Typography>

      <Stack spacing={3}>
        <Paper sx={{ p: 3 }}>
          <Typography variant="h4" component="h2" gutterBottom>
            Need Help?
          </Typography>
          <Typography variant="body1" color="text.secondary">
            If you encounter any issues or have questions about using ABE,
            please reach out to your system administrator or the ABE support team.
          </Typography>
        </Paper>

        <Paper sx={{ p: 3 }}>
          <Typography variant="h4" component="h2" gutterBottom>
            Reporting Issues
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Use the thumbs-down feedback button on any response to report
            inaccurate or unhelpful answers. Your feedback helps improve ABE&apos;s
            accuracy over time.
          </Typography>
        </Paper>
      </Stack>
    </Box>
  );
}
