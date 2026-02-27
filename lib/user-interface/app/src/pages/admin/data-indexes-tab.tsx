import { Stack } from "@mui/material";
import { useContext, useMemo } from "react";
import { AppContext } from "../../common/app-context";
import { ApiClient } from "../../common/api-client/api-client";
import IndexCard, { type IndexStatus, type IndexApiAdapter } from "./index-card";

interface DataIndexesTabProps {
  onContractStatusChange?: (status: IndexStatus | null) => void;
  onTradeStatusChange?: (status: IndexStatus | null) => void;
}

export default function DataIndexesTab({
  onContractStatusChange,
  onTradeStatusChange,
}: DataIndexesTabProps) {
  const appContext = useContext(AppContext);
  const apiClient = useMemo(() => new ApiClient(appContext), [appContext]);

  const contractApi: IndexApiAdapter = useMemo(
    () => ({
      getStatus: () => apiClient.contractIndex.getStatus(),
      getUploadUrl: () => apiClient.contractIndex.getUploadUrl(),
      getPreview: () => apiClient.contractIndex.getPreview(),
    }),
    [apiClient]
  );

  const tradeApi: IndexApiAdapter = useMemo(
    () => ({
      getStatus: () => apiClient.tradeIndex.getStatus(),
      getUploadUrl: () => apiClient.tradeIndex.getUploadUrl(),
      getPreview: () => apiClient.tradeIndex.getPreview(),
    }),
    [apiClient]
  );

  return (
    <Stack spacing={2.5}>
      <IndexCard
        title="Statewide Contract Index"
        description="Upload a single .xlsx file. It will replace the current index. The file should match the expected Statewide Contract Index schema."
        api={contractApi}
        onStatusChange={onContractStatusChange}
      />
      <IndexCard
        title="Trade Contract Index"
        description="Upload a single .xlsx file. It will replace the current Trade index. This is separate from the Statewide Contract Index."
        api={tradeApi}
        onStatusChange={onTradeStatusChange}
      />
    </Stack>
  );
}
