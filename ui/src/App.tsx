import { Box } from "@mui/material";
import { useRoute } from "./hooks/useRoute";
import { Layout } from "./components/Layout";
import { EngineGate } from "./components/EngineGate";
import { ContainersView } from "./views/containers/ContainersView";
import { ContainerDetail } from "./views/containers/ContainerDetail";
import { ProjectDetail } from "./views/projects/ProjectDetail";
import { VolumesView } from "./views/volumes/VolumesView";
import { VolumeDetail } from "./views/volumes/VolumeDetail";
import { ImagesView } from "./views/images/ImagesView";
import { ImageDetail } from "./views/images/ImageDetail";
import { SwarmView } from "./views/swarm/SwarmView";
import { ServiceDetail, StackDetail } from "./views/swarm/SwarmDetails";
import { EnginesView } from "./views/engines/EnginesView";
import { AccessView } from "./views/access/AccessView";
import { ServerFilesView } from "./views/serverfiles/ServerFilesView";
import { ServerDiskView } from "./views/serverdisk/ServerDiskView";
import { NetworksView } from "./views/networks/NetworksView";
import { NetworkDetail } from "./views/networks/NetworkDetail";
import { DiskUsageView } from "./views/disk/DiskUsageView";
import { PortsView } from "./views/ports/PortsView";
import { Placeholder } from "./views/Placeholder";

function Routes({ route }: { route: string[] }) {
  const [section, id, tab] = route;
  switch (section) {
    case undefined:
    case "containers":
      return id ? <ContainerDetail key={id} id={id} tab={tab} /> : <ContainersView />;
    case "projects":
      return id ? <ProjectDetail key={id} name={id} /> : <ContainersView />;
    case "images":
      return id ? <ImageDetail key={id} imageRef={id} tab={tab} /> : <ImagesView />;
    case "volumes":
      return id ? <VolumeDetail key={id} name={id} tab={tab} /> : <VolumesView />;
    case "swarm": {
      const [, sub, ref, subTab] = route;
      if (sub === "services" && ref) return <ServiceDetail key={ref} id={ref} tab={subTab} />;
      if (sub === "stacks" && ref) return <StackDetail key={ref} name={ref} tab={subTab} />;
      return <SwarmView tab={sub} />;
    }
    case "networks":
      return id ? <NetworkDetail key={id} id={id} tab={tab} /> : <NetworksView />;
    case "disk":
      return <DiskUsageView />;
    case "ports":
      return <PortsView />;
    case "engines":
      return <EnginesView />;
    case "access":
      return <AccessView />;
    case "server-files":
      return <ServerFilesView key={id ?? ""} path={id} />;
    case "server-disk":
      return <ServerDiskView path={id} />;
    default:
      return <Placeholder title="Not found" note={route.join("/")} />;
  }
}

export default function App() {
  const route = useRoute();
  const page = (
    <Box sx={{ p: 3, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Routes route={route} />
    </Box>
  );
  // Engine management and AI access don't depend on the active engine, so they stay reachable when it is down.
  return <Layout route={route}>{route[0] === "engines" || route[0] === "access" ? page : <EngineGate>{page}</EngineGate>}</Layout>;
}
