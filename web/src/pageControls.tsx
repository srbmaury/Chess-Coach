export function Heading({ kicker, title, copy, action }: { kicker: string; title: string; copy: string; action?: React.ReactNode }) { return <div className="heading"><div><p className="kicker">{kicker}</p><h1>{title}</h1><p>{copy}</p></div>{action}</div> }
export function ErrorBox({ message }: { message: string }) { return <div className="error">{message}</div> }
