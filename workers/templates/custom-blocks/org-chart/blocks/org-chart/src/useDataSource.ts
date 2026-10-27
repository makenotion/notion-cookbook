import { useEffect, useState } from "react"
import { customBlock } from "@notionhq/custom-blocks"
import type {
  CustomBlockQueryDataSourceErrorInfo,
  DataSourceSnapshot,
  UseDataSourceOptions,
} from "@notionhq/custom-blocks"

type DataSourceState = DataSourceSnapshot & {
  error: CustomBlockQueryDataSourceErrorInfo | undefined
}

export function useDataSource(
  key: string,
  options: UseDataSourceOptions
): DataSourceState {
  const [state, setState] = useState<DataSourceState>({
    items: [],
    propertyIdsByKey: {},
    isLoading: true,
    hasMore: false,
    error: undefined,
  })

  useEffect(
    () =>
      customBlock.subscribeToDataSource(
        {
          key,
          options,
          onSnapshot: (snapshot) => setState({ ...snapshot, error: undefined }),
        },
        (error) =>
          setState((previous) => ({ ...previous, isLoading: false, error }))
      ),
    [key, options]
  )

  return state
}
