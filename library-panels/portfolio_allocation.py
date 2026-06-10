@bind(holdings="instrument{portfolio=\"${portfolio_id}\", quantity != 0} @latest")
@metric(output="table")
def allocation(holdings):
    if holdings.is_empty():
        return holdings
    df = holdings.select(["instrument", "position_size_base"]).sort("position_size_base", descending=True)
    if df.height <= 10:
        return df
    top = df.head(10)
    rest = float(df.tail(df.height - 10)["position_size_base"].sum())
    other = pl.DataFrame({"instrument": ["Other"], "position_size_base": [rest]})
    return pl.concat([top, other], how="vertical")
