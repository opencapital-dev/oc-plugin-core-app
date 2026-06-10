@bind(rows="portfolios{}")
@metric(output="table")
def portfolios(rows):
    return rows
