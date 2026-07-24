import type { Person } from "./types"

/** ~12 people, 3 levels: a Design org plus a small Research root. */
export const MOCK_PEOPLE: Person[] = [
  {
    id: "p-maya",
    name: "Maya Chen",
    role: "Design Lead",
    managerIds: [],
    icon: { type: "emoji", emoji: "🦊" },
  },
  {
    id: "p-jonas",
    name: "Jonas Weber",
    role: "Product Designer II",
    managerIds: ["p-maya"],
  },
  {
    id: "p-priya",
    name: "Priya Natarajan",
    role: "Product Designer II",
    managerIds: ["p-maya"],
    icon: { type: "emoji", emoji: "🌸" },
  },
  {
    id: "p-alice",
    name: "Alice Nguyen",
    role: "Product Designer II",
    managerIds: ["p-maya"],
  },
  {
    id: "p-david",
    name: "David Park",
    role: "Product Designer II",
    managerIds: ["p-maya"],
  },
  {
    id: "p-sam",
    name: "Sam Okafor",
    role: "Product Designer I",
    managerIds: ["p-priya"],
    icon: { type: "emoji", emoji: "🐢" },
  },
  {
    id: "p-lena",
    name: "Lena Fischer",
    role: "Brand Designer",
    managerIds: ["p-priya"],
  },
  {
    id: "p-tomas",
    name: "Tomás Rivera",
    role: "Content Designer",
    managerIds: ["p-priya"],
  },
  {
    id: "p-ruth",
    name: "Ruth Alvarez",
    role: "Research Lead",
    managerIds: [],
    icon: { type: "emoji", emoji: "🌵" },
  },
  {
    id: "p-ken",
    name: "Ken Watanabe",
    role: "UX Researcher",
    managerIds: ["p-ruth"],
    icon: { type: "emoji", emoji: "🎧" },
  },
  {
    id: "p-ingrid",
    name: "Ingrid Larsen",
    role: "Research Ops",
    managerIds: ["p-ruth"],
  },
  {
    id: "p-omar",
    name: "Omar Haddad",
    role: "UX Researcher",
    managerIds: ["p-ruth"],
  },
]

/** Small 5-person sample rendered behind the setup card when unbound/empty. */
export const SAMPLE_PEOPLE: Person[] = [
  {
    id: "sample-riley",
    name: "Riley Morgan",
    role: "Head of Product",
    managerIds: [],
  },
  {
    id: "sample-ana",
    name: "Ana Souza",
    role: "Product Manager",
    managerIds: ["sample-riley"],
  },
  {
    id: "sample-ben",
    name: "Ben Ito",
    role: "Product Manager",
    managerIds: ["sample-riley"],
  },
  {
    id: "sample-chloe",
    name: "Chloe Dubois",
    role: "Engineer",
    managerIds: ["sample-ana"],
  },
  {
    id: "sample-dev",
    name: "Dev Patel",
    role: "Engineer",
    managerIds: ["sample-ana"],
  },
]
