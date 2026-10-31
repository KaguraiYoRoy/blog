import type { APIRoute, GetStaticPaths } from "astro";
import { typechoPageRedirects } from "../constants/typecho-redirects";

// An endpoint keeps the old .html URL as a file instead of a directory.
export const getStaticPaths = (() =>
	Object.entries(typechoPageRedirects).map(([source, destination]) => ({
		params: { legacy: source.slice(1, -".html".length) },
		props: { destination },
	}))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props, redirect }) =>
	redirect(props.destination, 301);
