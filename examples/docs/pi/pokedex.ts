import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

// pi-ai's Type builds the schema Pi checks every call against.
export const findPokemon = defineTool({
	name: "find_pokemon",
	description: "List the areas where a wild Pokémon appears in Pokémon HeartGold or SoulSilver.",
	parameters: Type.Object({
		pokemon: Type.String({ description: "Pokémon name in lowercase, such as sudowoodo." }),
		version: Type.Optional(Type.Union([Type.Literal("heartgold"), Type.Literal("soulsilver")])),
	}),
	replay: "safe",
	execute: async ({ pokemon, version = "soulsilver" }, _api, context) => {
		const url = `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(pokemon)}/encounters`;
		const response = await fetch(url, { signal: context.abortSignal });
		if (!response.ok) throw new Error(`PokéAPI returned ${response.status} for ${pokemon}.`);
		const encounters = (await response.json()) as Encounter[];
		const areas = encounters
			.filter((encounter) => encounter.version_details.some((detail) => detail.version.name === version))
			.map((encounter) => encounter.location_area.name);
		const text =
			areas.length > 0 ? `${pokemon} in ${version}: ${areas.join(", ")}.` : `No wild ${pokemon} in ${version}.`;
		return { content: [{ type: "text", text }] };
	},
});

type Encounter = {
	location_area: { name: string };
	version_details: { version: { name: string } }[];
};
