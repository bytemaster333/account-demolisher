"use client";

import { useCallback, useMemo, useState } from "react";

import type { RefusedConversion } from "@/lib/orchestrator/page-flow-machine";
import type { HeldToken } from "@/lib/soroban/held-tokens";

import { INITIAL_FORM, type FormState } from "../_lib/form";
import type { ConversionChoice } from "../_components/ConversionChoicesCard";
import type { CreditChoice, HeldTokenChoice } from "../_components/ResolvePanel";

export interface CloseChoices {
  readonly form: FormState;
  readonly setForm: React.Dispatch<React.SetStateAction<FormState>>;
  readonly selectedHeldTokens: readonly HeldToken[];
  readonly setSelectedHeldTokens: React.Dispatch<React.SetStateAction<readonly HeldToken[]>>;
  readonly convertHeldTokensToXLM: boolean;
  readonly setConvertHeldTokensToXLM: React.Dispatch<React.SetStateAction<boolean>>;
  readonly acceptedPriceKeys: readonly string[];
  readonly heldAnswers: ReadonlyMap<string, "asis" | "leave">;
  readonly forfeitPools: readonly string[];
  readonly claimSelection: readonly string[] | null;
  readonly setClaimSelection: React.Dispatch<React.SetStateAction<readonly string[] | null>>;
  // the answer on screen for each refused held-token conversion, by contract id
  readonly heldChoices: ReadonlyMap<string, HeldTokenChoice>;
  readonly onSetDisposal: (key: string, choice: CreditChoice) => void;
  readonly onConversionChoice: (key: string, choice: ConversionChoice) => void;
  readonly onHeldChoice: (r: RefusedConversion, choice: HeldTokenChoice) => void;
  readonly onForfeit: (poolId: string, agreed: boolean) => void;
  // drops the answers given for one plan: rates, held-token answers, forfeits
  // and the claim pick
  readonly clearChoices: () => void;
  // back to an empty form with no standalone tokens picked
  readonly resetForm: () => void;
}

// everything the user decides about the close, from the form on Configure to
// the answers given on the Resolve and Warnings steps
export function useCloseChoices(refused: readonly RefusedConversion[]): CloseChoices {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  // standalone SEP-41 tokens the user opted in to sweep (discovered ones they
  // ticked + any added by contract id). Kept outside the zod form because each
  // carries a bigint balance; default empty so nothing is swept without a choice.
  const [selectedHeldTokens, setSelectedHeldTokens] = useState<readonly HeldToken[]>([]);
  // opt-in: convert the opted-in held tokens to XLM (Soroswap-router swap) instead
  // of transferring them as-is. Default off: transfer-as-is preserves the exact
  // token and can't be defeated by an illiquid/unroutable one.
  const [convertHeldTokensToXLM, setConvertHeldTokensToXLM] = useState(false);
  // assets the user agreed to sell over the price-impact cap or unpriced
  // ("CODE:ISSUER", or "contract:C..." for a held token)
  const [acceptedPriceKeys, setAcceptedPriceKeys] = useState<readonly string[]>([]);
  // answers to refused held-token conversions, by contract id: send the token
  // as-is, or leave it on the account. accepting the new rate is an accepted
  // price key instead.
  const [heldAnswers, setHeldAnswers] = useState<ReadonlyMap<string, "asis" | "leave">>(new Map());
  // backstop pools whose unclaimable emissions the user agreed to leave behind
  const [forfeitPools, setForfeitPools] = useState<readonly string[]>([]);
  // the claimable balances the user picked; null until they change the planner's
  // choice, so the first plan claims every balance it can collect
  const [claimSelection, setClaimSelection] = useState<readonly string[] | null>(null);

  const onSetDisposal = useCallback((key: string, choice: CreditChoice) => {
    // a balance goes to at most one place, or is sold at the reviewed price
    setForm((f) => {
      const issuer = new Set(f.returnToIssuer);
      const dest = new Set(f.sendToDestination);
      issuer.delete(key);
      dest.delete(key);
      if (choice === "issuer") issuer.add(key);
      else if (choice === "destination") dest.add(key);
      return { ...f, returnToIssuer: [...issuer], sendToDestination: [...dest] };
    });
    setAcceptedPriceKeys((keys) => {
      const next = keys.filter((k) => k !== key);
      return choice === "accept" ? [...next, key] : next;
    });
  }, []);

  // a credit the close can sell within the price cap: keep selling it (an
  // accepted over-cap price stays accepted), or send or return it instead
  const onConversionChoice = useCallback(
    (key: string, choice: ConversionChoice) => {
      if (choice === "destination" || choice === "issuer") {
        onSetDisposal(key, choice);
        return;
      }
      setForm((f) => ({
        ...f,
        returnToIssuer: f.returnToIssuer.filter((k) => k !== key),
        sendToDestination: f.sendToDestination.filter((k) => k !== key),
      }));
    },
    [onSetDisposal],
  );

  // one answer per refused token: the new rate, as-is, or left on the account
  const onHeldChoice = useCallback((r: RefusedConversion, choice: HeldTokenChoice) => {
    setAcceptedPriceKeys((keys) => {
      const next = keys.filter((k) => k !== r.key);
      return choice === "accept" && r.refusal !== "no_route" ? [...next, r.key] : next;
    });
    setHeldAnswers((m) => {
      const next = new Map(m);
      if (choice === "asis" || choice === "leave") next.set(r.contractId, choice);
      else next.delete(r.contractId);
      return next;
    });
  }, []);
  const heldChoices = useMemo(() => {
    const out = new Map<string, HeldTokenChoice>();
    for (const r of refused) {
      out.set(
        r.contractId,
        heldAnswers.get(r.contractId) ?? (acceptedPriceKeys.includes(r.key) ? "accept" : "none"),
      );
    }
    return out;
  }, [refused, heldAnswers, acceptedPriceKeys]);

  const onForfeit = useCallback((poolId: string, agreed: boolean) => {
    setForfeitPools((pools) => {
      const next = pools.filter((p) => p !== poolId);
      return agreed ? [...next, poolId] : next;
    });
  }, []);

  const clearChoices = useCallback(() => {
    setAcceptedPriceKeys([]);
    setHeldAnswers(new Map());
    setForfeitPools([]);
    setClaimSelection(null);
  }, []);

  const resetForm = useCallback(() => {
    setForm(INITIAL_FORM);
    setSelectedHeldTokens([]);
    setConvertHeldTokensToXLM(false);
  }, []);

  return {
    form,
    setForm,
    selectedHeldTokens,
    setSelectedHeldTokens,
    convertHeldTokensToXLM,
    setConvertHeldTokensToXLM,
    acceptedPriceKeys,
    heldAnswers,
    forfeitPools,
    claimSelection,
    setClaimSelection,
    heldChoices,
    onSetDisposal,
    onConversionChoice,
    onHeldChoice,
    onForfeit,
    clearChoices,
    resetForm,
  };
}
