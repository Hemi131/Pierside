import { Link, Typography } from "@mui/material";
import ConstructionOutlinedIcon from "@mui/icons-material/ConstructionOutlined";
import { EmptyState, PageHeader } from "../components/common";

export function Placeholder({ title, note }: { title: string; note?: string }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState icon={<ConstructionOutlinedIcon sx={{ fontSize: 40 }} />} title="Not built yet">
        <Typography variant="body1">{note}</Typography>
        <Link href="#/containers" sx={{ mt: 1, display: "inline-block" }}>
          Back to containers
        </Link>
      </EmptyState>
    </>
  );
}
