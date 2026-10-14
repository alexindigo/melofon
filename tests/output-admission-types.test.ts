import type {
  OutputProtocol,
  PreparedTarget,
} from '../src/output-admission.ts';

// Compile-only expressions; intentionally invalid operations never execute.
export function admissionTypeContract(
  raop: OutputProtocol<
    'raop',
    { metadata: number },
    { volume: number },
    object,
    string
  >,
  url: PreparedTarget<
    'url',
    { url: string },
    { volume: number },
    object,
    string
  >,
  row: { id: string; host: string },
) {
  const lifecycle = {
    publish(_transport: object) {},
    onEvent(_event: string) {},
  };
  // @ts-expect-error Registered identity does not contain a prepared permit.
  raop.activate(row, { volume: 50 }, lifecycle);
  // @ts-expect-error A plain configuration cannot fabricate an owned permit.
  raop.activate({ metadata: 7 }, { volume: 50 }, lifecycle);
  // @ts-expect-error Protocol/configuration types must match.
  raop.activate(url, { volume: 50 }, lifecycle);
}
