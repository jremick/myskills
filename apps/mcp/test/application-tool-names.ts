import { DELEGATED_ACTIONS } from "@myskills-app/core";
export const FRIENDLY_READ_TOOLS = ["browse_bundles", "discover_skills", "get_architecture_projection", "get_install_instructions", "get_skill_info", "list_architecture_patterns", "list_architectures", "read_skill_file", "search_skills", "skills_releases_compare"];
export const ALL_APPLICATION_TOOL_NAMES = [...FRIENDLY_READ_TOOLS, "curate_bundle", "application_handoff", ...DELEGATED_ACTIONS.map(action => action.id.replaceAll(".", "_"))].sort();
