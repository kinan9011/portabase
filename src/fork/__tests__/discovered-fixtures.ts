import {readFileSync} from "node:fs";
import path from "node:path";
import {ArcaneClient} from "@/fork/arcane/client";
import type {DiscoveredContainer, DiscoveredImage, DiscoveredNetwork, DiscoveredProject, DiscoveredVolume} from "@/fork/discovery/provider";
import type {PinnedResponse} from "@/fork/net/pinned-request";

/** The scrubbed lab fixtures (`src/fork/arcane/__fixtures__`) run through the REAL client mapping, as Arcane would answer. */
const fx = (n: string) => JSON.parse(readFileSync(path.join(process.cwd(), "src/fork/arcane/__fixtures__", n), "utf8"));
export const RAW = {containers: fx("containers.list.json"), volumes: fx("volumes.list.json"), networks: fx("networks.list.json"), images: fx("images.list.json"), projects: fx("projects.list.json"), compose: fx("project.compose.json"), environments: fx("environments.list.json")};

export type Lists = {containers: DiscoveredContainer[]; volumes: DiscoveredVolume[]; networks: DiscoveredNetwork[]; images: DiscoveredImage[]; projects: DiscoveredProject[]};

export async function discoveredFrom(raw: {containers: unknown; volumes: unknown; networks: unknown; images: unknown; projects: unknown} = RAW): Promise<Lists> {
    const body: Record<string, unknown> = {containers: raw.containers, volumes: raw.volumes, networks: raw.networks, images: raw.images, projects: raw.projects};
    const c = await ArcaneClient.create({
        baseUrl: "https://arcane.example.com", apiKey: "arc_FIXTURE_KEY_00000000", resolve: async () => [{address: "93.184.216.34", family: 4}],
        transport: async (i): Promise<PinnedResponse> => {
            const m = /\/(containers|volumes|networks|images|projects)\?/.exec(i.path);
            return {status: 200, headers: {}, body: JSON.stringify(m ? body[m[1]] : {})};
        },
    });
    return {containers: await c.listContainers("0"), volumes: await c.listVolumes("0"), networks: await c.listNetworks("0"), images: await c.listImages("0"), projects: await c.listProjects("0")};
}

/** The live Arcane also lists the pre-created external network the demo stack joins; the scrubbed fixture dropped it. */
export const LAB_PROXY: DiscoveredNetwork = {id: "labproxy000000000000000000000000000000000000000000000000000000ab", name: "lab_proxy", driver: "bridge", scope: "local", labels: {}, inUse: true, isDefault: false};
